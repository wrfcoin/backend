/**
 * run-migrations must surface Postgres NOTICE/WARNING output (backend#1210
 * review follow-up): node-postgres emits notices per client and pg.Pool does
 * not forward them, so the runner subscribes on every connected client.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  attachMigrationNoticeLogging,
  formatMigrationNotice,
} from '../scripts/migration-notices.js';

function capture() {
  const info: string[] = [];
  const warn: string[] = [];
  return { info, warn, sink: { info: (l: string) => info.push(l), warn: (l: string) => warn.push(l) } };
}

describe('migration notice logging', () => {
  it('forwards WARNING to warn and NOTICE to info for every connected client', () => {
    const pool = new EventEmitter();
    const { info, warn, sink } = capture();
    attachMigrationNoticeLogging(pool as never, sink);

    const clientA = new EventEmitter();
    const clientB = new EventEmitter();
    pool.emit('connect', clientA);
    pool.emit('connect', clientB);

    clientA.emit('notice', {
      severity: 'WARNING',
      message: 'backend#1210 owner case COLLISION left unchanged: weather_stations.owner_address owner 0xbb… has 2 case variants over 2 rows',
    });
    clientB.emit('notice', {
      severity: 'NOTICE',
      message: 'backend#1210 owner case: weather_stations.owner_address lowercased 2 rows, 1 collision groups left unchanged',
    });

    expect(warn).toEqual([
      '[migrate] WARNING: backend#1210 owner case COLLISION left unchanged: weather_stations.owner_address owner 0xbb… has 2 case variants over 2 rows',
    ]);
    expect(info).toEqual([
      '[migrate] NOTICE: backend#1210 owner case: weather_stations.owner_address lowercased 2 rows, 1 collision groups left unchanged',
    ]);
  });

  it('includes detail and hint, and defaults a missing severity to NOTICE', () => {
    expect(formatMigrationNotice({ message: 'm', detail: 'd', hint: 'h' })).toBe(
      '[migrate] NOTICE: m (detail: d) (hint: h)',
    );
  });

  it('run-migrations wires the logger onto its pool before migrating', () => {
    const src = readFileSync('scripts/run-migrations.ts', 'utf8');
    const attach = src.indexOf('attachMigrationNoticeLogging(pool)');
    const migrate = src.indexOf('await migrate(');
    expect(attach).toBeGreaterThan(-1);
    expect(attach).toBeLessThan(migrate);
  });
});
