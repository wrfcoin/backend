/**
 * Forward Postgres NOTICE / WARNING messages raised while migrations run to
 * the migration runner's own output (backend#1210 review follow-up).
 *
 * node-postgres does not print server notices; it emits them as a `notice`
 * event on the client that received them. Without this, a migration's
 * `RAISE WARNING` (e.g. 0020's owner-address case-collision report) reaches
 * only the Postgres server log and never the deploy log.
 *
 * `pg.Pool` does not re-emit client notices, so we subscribe on every client
 * the pool connects. Every notice is written once, on its own line, prefixed
 * with `[migrate]` and its severity; WARNING and above go to the warn stream.
 */

export interface MigrationNotice {
  severity?: string;
  message?: string;
  detail?: string;
  hint?: string;
}

interface NoticeEmitter {
  on(event: 'notice', listener: (notice: MigrationNotice) => void): unknown;
}

interface ConnectEmitter {
  on(event: 'connect', listener: (client: NoticeEmitter) => void): unknown;
}

export interface MigrationNoticeSink {
  info(line: string): void;
  warn(line: string): void;
}

const INFO_SEVERITIES = new Set(['DEBUG', 'LOG', 'INFO', 'NOTICE']);

export function formatMigrationNotice(notice: MigrationNotice): string {
  const severity = (notice.severity || 'NOTICE').toUpperCase();
  let line = `[migrate] ${severity}: ${notice.message ?? ''}`;
  if (notice.detail) line += ` (detail: ${notice.detail})`;
  if (notice.hint) line += ` (hint: ${notice.hint})`;
  return line;
}

export function attachMigrationNoticeLogging(
  pool: ConnectEmitter,
  sink: MigrationNoticeSink = {
    info: (line) => console.log(line),
    warn: (line) => console.warn(line),
  },
): void {
  pool.on('connect', (client) => {
    client.on('notice', (notice) => {
      const severity = (notice.severity || 'NOTICE').toUpperCase();
      const line = formatMigrationNotice(notice);
      if (INFO_SEVERITIES.has(severity)) {
        sink.info(line);
      } else {
        sink.warn(line);
      }
    });
  });
}
