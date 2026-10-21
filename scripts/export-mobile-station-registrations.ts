/**
 * Export `db_only` per-phone station registrations for the operator's on-chain
 * batch ceremony (backend#1288 story B5; design §3.5 option A).
 *
 * Reads mobile_station_registrations WHERE status = 'db_only' and writes a
 * `mobile_station_registration_export_v1` JSON file. Each `stations[]` entry has
 * station_id, owner_address, owner_pubkey, owner_signature (the owner's signature
 * over the station-ownership preimage B, core4 `station_ownership_message`),
 * latitude/longitude (the 0.1 degree cell's grid point) plus `cell` in integer
 * tenths, hardware_model `phone-barometer`, data_quality_tier `unverified` (explicit; see mobile-station-export.ts), chain_id, network_id and the proposed
 * provenance_class `real` - snake_case, one object per registration. Each row is re-verified first; failures are skipped
 * and listed by station id only.
 *
 * NO governance key is read, held or needed here. Signing happens in the
 * operator ceremony. NOTE (gap, core4 CLI follow-up wrfcoin/core4#3383): today's
 * `wrfcoin-cli station build-registration` takes `--owner-key <private key file>`
 * and signs ownership itself, so it cannot consume owner_pubkey/owner_signature
 * until #3383 adds `--owner-pubkey`/`--owner-signature` and a `--batch` input.
 * This file's `stations[]` entries are shaped for that `--batch` input.
 *
 * DRY-RUN by default: it never changes a row. `--mark-submitted` (explicit) moves
 * ONLY the exported ids db_only -> submitted, and only after the file has been
 * written successfully, stamping `governance_batch_id` with --batch-id.
 *
 * The output holds station cells: never commit a real one.
 *
 * Environment:
 *   DATABASE_URL          postgres connection string
 *   WRFCOIN_CHAIN_ID      default 777        (must equal the chain the phone signed for)
 *   WRFCOIN_NETWORK_ID    default testnet
 *
 * Usage:
 *   npx tsx scripts/export-mobile-station-registrations.ts --out /path/batch.json --batch-id <id>
 *   npx tsx scripts/export-mobile-station-registrations.ts --out /path/batch.json --batch-id <id> --mark-submitted
 *   Optional: --limit <n> (default 21, max 63). With --cli-batch-out, at most
 *     21 rows (core4#3388 artifact calibration) and 65536 UTF-8 input bytes.
 *     The CLI still enforces its actual signed pretty-artifact byte ceiling.
 *   Optional: --cli-batch-out <file> --submitted-at <unix secs> ALSO writes the bare JSON array that
 *     `wrfcoin station build-registration --batch` accepts (only the keys core4's deny_unknown_fields
 *     row takes; submitted_at is the operator-supplied value, no clock read). Same 0600 + 'wx' write.
 *
 * Exit codes: 0 = exported (skipped rows, if any, are listed); 2 = nothing to
 * export or every row skipped; 1 = usage/connection error.
 */
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { resolveMobileStationChain } from '../server/services/mobile-station-registration-service.js';
import { runExportCli, type ExportPool } from '../server/services/mobile-station-export-cli.js';

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    return 1;
  }
  let chain: { chainId: string; networkId: string };
  try {
    chain = resolveMobileStationChain();
  } catch {
    console.error('chain configuration is invalid (details withheld)');
    return 1;
  }
  const sql = postgres(databaseUrl, { max: 1 });
  const pool: ExportPool = {
    query: async (text, params = []) => {
      const rows = await sql.unsafe(text, params as any[]);
      return { rows: rows as unknown as any[], rowCount: (rows as any).count ?? rows.length };
    },
  };
  try {
    return await runExportCli(process.argv.slice(2), {
      pool,
      chain,
      writeFile: (path, data) => writeFileSync(path, data, { flag: 'wx', mode: 0o600 }),
      log: (m) => console.log(m),
      error: (m) => console.error(m),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then((code) => process.exit(code));
