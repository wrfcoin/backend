/**
 * Backfill `weather_stations` from the chain's station registry (backend#1250).
 *
 * Replaces the #788 stopgap `scripts/seed-jon-station.ts`, whose hard-coded
 * owner did not match the chain. The owner here is always read from the node's
 * canonical registration; the input file supplies only display name, location
 * label and coordinates (the chain read does not expose coordinates).
 *
 * DRY-RUN BY DEFAULT. Nothing is written without --apply.
 *
 * Input file (JSON array; NEVER commit a real one — it holds station coordinates):
 *   [{ "stationId": "PWS-...", "name": "...", "location": "City, ST",
 *      "latitude": 46.8, "longitude": -92.1, "stationType": "Ambient Weather WS-5000" }]
 *
 * Environment (names as set on the live backend container):
 *   DATABASE_URL            postgres connection string
 *   CORE4_API_URL           node API base (e.g. http://wrfcoin-node:8556)
 *   WRFCOIN_OPERATOR_TOKEN  bearer token for the operator-gated registration read
 *
 * Usage:
 *   npx tsx scripts/backfill-chain-stations.ts --input /path/stations.json          # dry run
 *   npx tsx scripts/backfill-chain-stations.ts --input /path/stations.json --apply  # write
 *
 * Exit codes: 0 = every row planned/applied cleanly (inserts, fills, no-ops);
 * 2 = at least one row refused or not written; 1 = usage/connection error.
 * Output never prints a full owner address or coordinates.
 */

import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import {
  SafeDiagnosticError,
  applyBackfill,
  nodeRegistrationFetcher,
  planBackfill,
  type BackfillPool,
} from '../server/services/chain-station-backfill.js';

/** Only an allowlisted-shape error code (e.g. ENOENT, ECONNREFUSED, 28P01) — never a message. */
function safeCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? ` (${code})` : '';
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const inputPath = arg('--input');
  const apply = process.argv.includes('--apply');
  if (!inputPath) {
    console.error('usage: backfill-chain-stations.ts --input <stations.json> [--apply]');
    return 1;
  }
  const databaseUrl = process.env.DATABASE_URL;
  const nodeUrl = process.env.CORE4_API_URL || process.env.BLOCKCHAIN_NODE_URL;
  const token = process.env.WRFCOIN_OPERATOR_TOKEN;
  const missing = [
    !databaseUrl && 'DATABASE_URL',
    !nodeUrl && 'CORE4_API_URL',
    !token && 'WRFCOIN_OPERATOR_TOKEN',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`missing env: ${missing.join(', ')}`);
    return 1;
  }

  // Fixed diagnostics only: a JSON.parse excerpt or fs message can echo the
  // file's bytes, i.e. station coordinates (#1251 review P2).
  let rawInput: string;
  try {
    rawInput = readFileSync(inputPath, 'utf8');
  } catch (error) {
    console.error(`input file unreadable${safeCode(error)}`);
    return 1;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    console.error('input file is not valid JSON');
    return 1;
  }
  if (!Array.isArray(parsed)) {
    console.error('input must be a JSON array of station rows');
    return 1;
  }

  const sql = postgres(databaseUrl as string, { max: 1 });
  const pool: BackfillPool = {
    query: async (text, params = []) => {
      const rows = await sql.unsafe(text, params as any[]);
      return { rows: Array.from(rows), count: rows.count };
    },
  };
  try {
    const plan = await planBackfill(parsed, nodeRegistrationFetcher(nodeUrl as string, token as string), pool);
    console.log(`${apply ? 'APPLY' : 'DRY-RUN'}: ${plan.length} input row(s)`);
    for (const item of plan) console.log(`  plan ${item.action.padEnd(16)} ${item.stationId}  ${item.reason}`);
    let clean = plan.every((p) => p.action !== 'refuse');
    if (!apply) {
      console.log('dry run only; re-run with --apply to write the insert/fill-coordinates rows');
      return clean ? 0 : 2;
    }
    const results = await applyBackfill(plan, pool);
    for (const r of results) {
      if (r.action === 'insert' || r.action === 'fill-coordinates') {
        console.log(`  ${r.written ? 'wrote' : 'SKIPPED'} ${r.action.padEnd(16)} ${r.stationId}  ${r.reason}`);
        if (!r.written) clean = false;
      }
    }
    return clean ? 0 : 2;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // Database / network failures: category + safe code only; driver and
    // socket messages can carry query parameters (coordinates).
    const detail = err instanceof SafeDiagnosticError ? `: ${err.message}` : safeCode(err);
    console.error(`backfill failed: database or node error${detail} (details withheld)`);
    process.exit(1);
  }
);
