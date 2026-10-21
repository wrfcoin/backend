import { readFileSync } from 'node:fs';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import {
  oracleWorkClaimResults,
  oracleWorkItems,
  stationRewardCycles,
} from '../shared/oracle-work-schema.js';

const migration = readFileSync('drizzle/migrations/0018_oracle_work_broker.sql', 'utf8');
const rewardMigration = readFileSync('drizzle/migrations/0016_station_reward_progress.sql', 'utf8');
// backend#1210: expression indexes on lower(owner_address) for station_reward_cycles.
const ownerLowerIndexMigration = readFileSync('drizzle/migrations/0021_owner_address_lower_indexes.sql', 'utf8');
const drizzleConfig = readFileSync('drizzle.config.ts', 'utf8');
const dialect = new PgDialect();

type ColumnShape = { name: string; type: string; notNull: boolean; default: string | null; primary: boolean };
type IndexShape = { name: string; unique: boolean; columns: string[]; orders: string[]; where: string | null };
type ForeignKeyShape = { name: string; columns: string[]; foreignTable: string; foreignColumns: string[]; onDelete: string | null };
type TableShape = {
  columns: ColumnShape[];
  indexes: IndexShape[];
  foreignKeys: ForeignKeyShape[];
  checks: { name: string; expression: string }[];
  primaryKeys: string[][];
};

function normalizeSql(value: string): string {
  return value
    .replace(/"[^"]+"\./g, '')
    .replace(/"/g, '')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let singleQuoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && value[index - 1] !== '\\') singleQuoted = !singleQuoted;
    if (singleQuoted) continue;
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function emptyTable(): TableShape {
  return { columns: [], indexes: [], foreignKeys: [], checks: [], primaryKeys: [] };
}

function parseColumn(item: string): ColumnShape | null {
  const match = item.match(/^"([^"]+)"\s+(text|integer|bigint|jsonb|timestamp with time zone|double precision|boolean|bigserial)\b([\s\S]*)$/i);
  if (!match) return null;
  const suffix = match[3].trim();
  const defaultMatch = suffix.match(/\bDEFAULT\s+([\s\S]+)$/i);
  return {
    name: match[1],
    type: match[2].toLowerCase(),
    notNull: /\bNOT NULL\b/i.test(suffix) || /\bPRIMARY KEY\b/i.test(suffix),
    default: defaultMatch ? normalizeSql(defaultMatch[1]).replace(/^'([^']*)'$/, '$1') : null,
    primary: /\bPRIMARY KEY\b/i.test(suffix),
  };
}

function parseTableItems(table: TableShape, body: string): void {
  for (const item of splitTopLevel(body)) {
    const column = parseColumn(item);
    if (column) {
      table.columns.push(column);
      continue;
    }
    const foreignKey = item.match(/^CONSTRAINT\s+"([^"]+)"\s+FOREIGN KEY\s*\(([^)]+)\)\s+REFERENCES\s+"([^"]+)"\s*\(([^)]+)\)(?:\s+ON DELETE\s+([a-z ]+))?$/i);
    if (foreignKey) {
      table.foreignKeys.push({
        name: foreignKey[1],
        columns: splitTopLevel(foreignKey[2]).map(value => value.replace(/"/g, '').trim()),
        foreignTable: foreignKey[3],
        foreignColumns: splitTopLevel(foreignKey[4]).map(value => value.replace(/"/g, '').trim()),
        onDelete: foreignKey[5]?.trim().toLowerCase() ?? null,
      });
      continue;
    }
    const check = item.match(/^CONSTRAINT\s+"([^"]+)"\s+CHECK\s*\(([\s\S]*)\)$/i);
    if (check) {
      table.checks.push({ name: check[1], expression: normalizeSql(check[2]) });
      continue;
    }
    const primaryKey = item.match(/^PRIMARY KEY\s*\(([^)]+)\)$/i);
    if (primaryKey) {
      table.primaryKeys.push(splitTopLevel(primaryKey[1]).map(value => value.replace(/"/g, '').trim()));
      continue;
    }
    const unique = item.match(/^CONSTRAINT\s+"([^"]+)"\s+UNIQUE\s*\(([^)]+)\)$/i);
    if (unique) {
      table.indexes.push({
        name: unique[1],
        unique: true,
        columns: splitTopLevel(unique[2]).map(value => value.replace(/"/g, '').trim()),
        orders: splitTopLevel(unique[2]).map(() => 'asc'),
        where: null,
      });
    }
  }
}

function parseMigration(sql: string): Record<string, TableShape> {
  const tables: Record<string, TableShape> = {};
  for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+"([^"]+)"\s*\(([\s\S]*?)\n\);/gi)) {
    tables[match[1]] = emptyTable();
    parseTableItems(tables[match[1]], match[2]);
  }
  for (const match of sql.matchAll(/ALTER TABLE\s+"([^"]+)"\s+([\s\S]*?);/gi)) {
    const table = tables[match[1]] ?? (tables[match[1]] = emptyTable());
    for (const column of match[2].matchAll(/ADD COLUMN IF NOT EXISTS\s+"([^"]+)"\s+([^,;]+?)(?=\s*,?\s*ADD COLUMN IF NOT EXISTS|$)/gi)) {
      parseTableItems(table, `"${column[1]}" ${column[2].trim()}`);
    }
  }
  for (const match of sql.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+IF NOT EXISTS\s+"([^"]+)"\s+ON\s+"([^"]+)"\s*\(/gi)) {
    // Balanced-paren column list, so expression columns such as
    // lower("owner_address") parse as one column (backend#1210).
    const open = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let close = open;
    while (close < sql.length && depth > 0) {
      if (sql[close] === '(') depth += 1;
      if (sql[close] === ')') depth -= 1;
      close += 1;
    }
    const list = sql.slice(open, close - 1);
    const where = /^\s+WHERE\s+([\s\S]*?);/i.exec(sql.slice(close))?.[1];
    const columns = splitTopLevel(list).map(value => value.replace(/"/g, '').replace(/\s+(?:DESC|ASC)\s*$/i, '').trim());
    const orders = splitTopLevel(list).map(value => /\bDESC\b/i.test(value) ? 'desc' : 'asc');
    (tables[match[3]] ?? (tables[match[3]] = emptyTable())).indexes.push({
      name: match[2], unique: Boolean(match[1]), columns, orders, where: where ? normalizeSql(where) : null,
    });
  }
  return tables;
}

function drizzleTableShape(table: Parameters<typeof getTableConfig>[0]): TableShape {
  const config = getTableConfig(table);
  const inlinePrimaryColumns = Object.values(table as Record<string, unknown>)
    .filter(value => Boolean((value as any)?.primary))
    .map(value => (value as { name: string }).name);
  return {
    columns: config.columns.map(column => {
      const rawDefault = (column as typeof column & { default?: unknown }).default;
      const value = rawDefault && typeof rawDefault === 'object' && 'queryChunks' in rawDefault
        ? dialect.sqlToQuery(rawDefault as never).sql
        : rawDefault;
      return {
        name: column.name,
        type: column.getSQLType().toLowerCase(),
        notNull: column.notNull,
        default: column.hasDefault ? normalizeSql(String(value)) : null,
        primary: Boolean((column as typeof column & { primary?: boolean }).primary),
      };
    }),
    indexes: config.indexes.map(index => ({
      name: index.config.name ?? '',
      unique: index.config.unique,
      columns: index.config.columns.map(column => (
        typeof (column as { name?: unknown }).name === 'string'
          ? (column as { name: string }).name.replace(/\s+(?:DESC|ASC)$/i, '')
          // Expression column (e.g. sql`lower(${table.ownerAddress})`).
          : normalizeSql(dialect.sqlToQuery(column as never).sql)
      )),
      orders: index.config.columns.map(column => ((column as { indexConfig?: { order?: string } }).indexConfig?.order ?? 'asc')),
      where: index.config.where ? normalizeSql(dialect.sqlToQuery(index.config.where).sql) : null,
    })),
    foreignKeys: config.foreignKeys.map(foreignKey => {
      const reference = foreignKey.reference();
      return {
        name: foreignKey.getName(),
        columns: reference.columns.map(column => column.name),
        foreignTable: (reference.foreignTable as Record<symbol, string>)[Symbol.for('drizzle:Name')],
        foreignColumns: reference.foreignColumns.map(column => column.name),
        onDelete: foreignKey.onDelete ?? null,
      };
    }),
    checks: config.checks.map(check => ({ name: check.name, expression: normalizeSql(dialect.sqlToQuery(check.value).sql) })),
    primaryKeys: [
      ...config.primaryKeys.map(primaryKey => primaryKey.columns.map(column => column.name)),
      ...(inlinePrimaryColumns.length > 0 ? [inlinePrimaryColumns] : []),
    ],
  };
}

function comparable(shape: TableShape): TableShape {
  const inlinePrimaryNames = new Set(shape.columns.filter(column => column.primary).map(column => column.name));
  return {
    columns: [...shape.columns].sort((a, b) => a.name.localeCompare(b.name)),
    indexes: [...shape.indexes].sort((a, b) => a.name.localeCompare(b.name)),
    foreignKeys: [...shape.foreignKeys].sort((a, b) => a.name.localeCompare(b.name)),
    checks: [...shape.checks].sort((a, b) => a.name.localeCompare(b.name)),
    primaryKeys: [...shape.primaryKeys]
      .filter(key => key.length > 1 || !inlinePrimaryNames.has(key[0]))
      .sort((a, b) => a.join(',').localeCompare(b.join(','))),
  };
}

test('Drizzle declarations structurally match migrations 0016, 0018 and 0021', () => {
  const migrations = parseMigration(`${rewardMigration}\n${migration}\n${ownerLowerIndexMigration}`);
  expect(comparable(migrations.station_reward_cycles)).toEqual(comparable(drizzleTableShape(stationRewardCycles)));
  expect(comparable(migrations.oracle_work_items)).toEqual(comparable(drizzleTableShape(oracleWorkItems)));
  expect(comparable(migrations.oracle_work_claim_results)).toEqual(comparable(drizzleTableShape(oracleWorkClaimResults)));
  expect(drizzleConfig).toContain("'./shared/oracle-work-schema.ts'");
});

test('structural parity fails on a semantic mutation that preserves invariant names', () => {
  const mutated = migration.replace('"required_quorum" integer NOT NULL DEFAULT 2', '"required_quorum" text NOT NULL DEFAULT 2');
  const migrations = parseMigration(`${rewardMigration}\n${mutated}\n${ownerLowerIndexMigration}`);
  expect(comparable(migrations.oracle_work_items)).not.toEqual(comparable(drizzleTableShape(oracleWorkItems)));
});

test('structural parity fails when the lower(owner_address) expression index drifts (backend#1210)', () => {
  const mutated = ownerLowerIndexMigration.replace('(lower("owner_address"), "station_id"', '("owner_address", "station_id"');
  expect(mutated).not.toBe(ownerLowerIndexMigration);
  const migrations = parseMigration(`${rewardMigration}\n${migration}\n${mutated}`);
  expect(comparable(migrations.station_reward_cycles)).not.toEqual(comparable(drizzleTableShape(stationRewardCycles)));
});
