export const MAX_BLOCK_READS = 30;
// At most 38 reads/minute, including pass boundaries, below the 40/min target and 100/min node limit.
export const MAX_READS_PER_MINUTE = 38;
export const READ_PACE_MS = Math.ceil(60_000 / MAX_READS_PER_MINUTE);
export const RUN_INTERVAL_MS = 5 * 60_000;
export const CATCHUP_THRESHOLD = 100;
export const MAX_ERROR_BACKOFF_MS = 60 * 60_000;
export function errorBackoffMs(failures: number): number {
  return Math.min(MAX_ERROR_BACKOFF_MS, RUN_INTERVAL_MS * 2 ** Math.min(4, Math.max(0, failures - 1)));
}
export function passDelayMs(status: string, lag: number | null, failures: number, startedAt: number, now: number): number {
  if (status !== 'ok' && status !== 'budget') return errorBackoffMs(failures);
  if (lag !== null && lag > CATCHUP_THRESHOLD) return 0;
  return Math.max(0, startedAt + RUN_INTERVAL_MS - now);
}
