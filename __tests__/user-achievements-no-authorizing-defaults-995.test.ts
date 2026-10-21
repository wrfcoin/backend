/**
 * backend#995: user_achievements authorized a mint by row existence and its column defaults (progress 100,
 * status 'completed') made a bare INSERT (user_id, achievement_id) immediately claimable. #994 bounds how much
 * can emit; this removes the authorizing defaults so a bare insert is inert (refused by NOT NULL).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from '@jest/globals';
import { userAchievements } from '../shared/schema.ts';

describe('user_achievements has no authorizing column defaults (#995)', () => {
  const columns = getTableColumns(userAchievements);

  it('progress and status have no default, so a writer must state them', () => {
    expect(columns.progress.hasDefault).toBe(false);
    expect(columns.status.hasDefault).toBe(false);
    expect(columns.progress.notNull).toBe(true);
    expect(columns.status.notNull).toBe(true);
  });

  it('a bare (user_id, achievement_id) insert is refused by the table definition: nothing fills the claim columns', () => {
    const fillers = Object.entries(columns)
      .filter(([, c]) => c.hasDefault || !c.notNull)
      .map(([name]) => name);
    expect(fillers).not.toContain('progress');
    expect(fillers).not.toContain('status');
  });

  it('the migration looks the table up through the search_path, drops both defaults only for the progress+status shape, verifies, and refuses an unknown one', () => {
    const dir = 'drizzle/migrations';
    const sql = readdirSync(dir)
      .filter(f => f.endsWith('.sql') && f > '0028')
      .map(f => readFileSync(`${dir}/${f}`, 'utf8').replace(/^\s*--.*$/gm, ''))
      .join('\n');
    // The table is the one the app sees (search_path), never current_schema(); statements use that relation.
    expect(sql).toMatch(/tbl := to_regclass\('user_achievements'\)/);
    expect(sql).not.toMatch(/current_schema\(\)/);
    expect(sql).not.toMatch(/information_schema/);
    // Both defaults are dropped, and only inside the branch that requires both columns.
    expect(sql).toMatch(/IF has_progress AND has_status THEN\s+EXECUTE format\('ALTER TABLE %s ALTER COLUMN progress DROP DEFAULT', tbl\);\s+EXECUTE format\('ALTER TABLE %s ALTER COLUMN status DROP DEFAULT', tbl\);/);
    expect(sql.match(/DROP DEFAULT/g)).toHaveLength(2);
    // A silent no-op is impossible: the defaults are re-read after the ALTER and a leftover raises.
    expect(sql).toMatch(/atthasdef\s*\) THEN\s+RAISE EXCEPTION/);
    // Every other tracked shape is left alone; the unknown one raises.
    expect(sql).toMatch(/tbl IS NULL THEN/);
    expect(sql).toMatch(/has_status AND NOT has_progress THEN\s+RAISE EXCEPTION/);
    expect(sql).toMatch(/ELSIF has_progress THEN\s+RAISE NOTICE/);
    expect(sql).not.toMatch(/DROP NOT NULL/);
  });

  it('the migration is in the drizzle journal', () => {
    const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8'));
    expect(journal.entries.map((e: any) => e.tag)).toContain('0029_user_achievements_no_authorizing_defaults');
  });
});
