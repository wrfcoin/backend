/**
 * The export CLI's logic, separated from process/DB plumbing so the dry-run
 * default is testable (scripts/export-mobile-station-registrations.ts wires the
 * real Postgres pool, file writer and console).
 */
import {
  buildCliBatch,
  buildExportArtifact,
  markRowsSubmitted,
  selectDbOnlyRows,
  type ExportPool,
} from './mobile-station-export.js';

export type { ExportPool };

export const MAX_MOBILE_STATION_EXPORT_ROWS = 63;
// core4#3388: complete phone artifacts measure 62,631 bytes at 21 rows;
// 22 rows exceed 64 KiB. This recommendation does not replace CLI enforcement.
export const DEFAULT_MOBILE_STATION_EXPORT_ROWS = 21;
export const MAX_MOBILE_STATION_CLI_INPUT_BYTES = 64 * 1024;

export interface ExportCliDeps {
  pool: ExportPool;
  chain: { chainId: string; networkId: string };
  /** Must fail if the file already exists (the wrapper passes flag 'wx'). */
  writeFile: (path: string, data: string) => void;
  log: (message: string) => void;
  error: (message: string) => void;
}

function safeCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? ` (${code})` : '';
}

/** Exit codes: 0 exported, 2 nothing to export, 1 usage or database/file error. */
export async function runExportCli(argv: string[], deps: ExportCliDeps): Promise<number> {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out = arg('--out');
  const batchId = arg('--batch-id');
  const markSubmitted = argv.includes('--mark-submitted');
  // A flag that is PRESENT but has no value (trailing) or whose value is another flag is a
  // usage error, never "absent": otherwise the export would run and mark rows submitted
  // without the batch the operator asked for.
  const hasValue = (name: string): boolean => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--');
  };
  const cliBatchFlagPresent = argv.includes('--cli-batch-out');
  const submittedAtFlagPresent = argv.includes('--submitted-at');
  const cliBatchOut = hasValue('--cli-batch-out') ? arg('--cli-batch-out') : undefined;
  const submittedAtRaw = hasValue('--submitted-at') ? arg('--submitted-at') : undefined;
  const submittedAt = submittedAtRaw === undefined ? undefined : Number(submittedAtRaw);
  const limit = Number(arg('--limit') ?? DEFAULT_MOBILE_STATION_EXPORT_ROWS);
  if ((argv.includes('--limit') && !hasValue('--limit')) || !Number.isInteger(limit) || limit < 1 || limit > MAX_MOBILE_STATION_EXPORT_ROWS) {
    deps.error(`--limit must be an integer from 1 to ${MAX_MOBILE_STATION_EXPORT_ROWS} (default ${DEFAULT_MOBILE_STATION_EXPORT_ROWS}); split larger exports into separate batches`);
    return 1;
  }
  if (!out || !batchId || !/^[A-Za-z0-9._-]{1,64}$/.test(batchId)) {
    deps.error('usage: export-mobile-station-registrations.ts --out <file> --batch-id <id> [--limit <1-63>] [--mark-submitted] [--cli-batch-out <file> --submitted-at <unix secs>]');
    return 1;
  }
  // --cli-batch-out needs an explicit, deterministic timestamp (the builder never reads the clock);
  // a stray --submitted-at without an output file is refused rather than silently ignored.
  const cliFlagsOk =
    (!cliBatchFlagPresent && !submittedAtFlagPresent) ||
    (cliBatchOut !== undefined &&
      cliBatchOut !== '' &&
      submittedAtRaw !== undefined &&
      /^[0-9]{1,15}$/.test(submittedAtRaw) &&
      Number.isSafeInteger(submittedAt) &&
      (submittedAt as number) > 0 &&
      cliBatchOut !== out);
  if (!cliFlagsOk) {
    deps.error('--cli-batch-out <file> (different from --out) and --submitted-at <positive unix secs> must be given together');
    return 1;
  }
  try {
    const { chainId, networkId } = deps.chain;
    const rows = await selectDbOnlyRows(deps.pool, limit);
    const { artifact, skipped } = buildExportArtifact(rows, { chainId, networkId, batchId });
    for (const s of skipped) deps.error(`skipped ${s.stationId}: ${s.reason}`);
    if (artifact.stations.length === 0) {
      deps.error(`nothing to export (${rows.length} db_only row(s) read, ${skipped.length} skipped)`);
      return 2;
    }
    let cliBatchData: string | undefined;
    if (cliBatchOut !== undefined) {
      const batch = buildCliBatch(artifact.stations, submittedAt as number);
      cliBatchData = JSON.stringify(batch, null, 2) + '\n';
      const bytes = Buffer.byteLength(cliBatchData, 'utf8');
      if (bytes > MAX_MOBILE_STATION_CLI_INPUT_BYTES) {
        deps.error(`projected CLI input is ${bytes} bytes; maximum ${MAX_MOBILE_STATION_CLI_INPUT_BYTES}. Split into smaller batches; nothing written or marked`);
        return 1;
      }
      if (batch.length > DEFAULT_MOBILE_STATION_EXPORT_ROWS) {
        deps.error(`CLI batch has ${batch.length} rows; calibrated phone artifact limit is ${DEFAULT_MOBILE_STATION_EXPORT_ROWS} under 65536 bytes. Split into smaller batches; nothing written or marked`);
        return 1;
      }
    }
    // Validate the complete projection before either write or the database mark.
    deps.writeFile(out, JSON.stringify(artifact, null, 2) + '\n');
    if (cliBatchOut !== undefined && cliBatchData !== undefined) {
      deps.writeFile(cliBatchOut, cliBatchData);
      deps.log(`wrote ${artifact.stations.length} core4 CLI batch row(s) to ${cliBatchOut}`);
    }
    deps.log(`wrote ${artifact.stations.length} station(s) to ${out} (batch ${batchId}, chain ${chainId}/${networkId})`);
    if (markSubmitted) {
      const n = await markRowsSubmitted(deps.pool, artifact.stations.map((s) => s.station_id), batchId);
      deps.log(`marked ${n} row(s) submitted`);
    } else {
      deps.log('dry run: no rows changed (pass --mark-submitted to mark them submitted)');
    }
    return 0;
  } catch (error) {
    deps.error(`export failed: database or file error${safeCode(error)} (details withheld)`);
    return 1;
  }
}
