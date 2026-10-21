/**
 * backend#1310 P3-b: server/enhanced_weather_rewards.ts is a standalone, legacy-
 * schema service (its insert names `id`/`user_id` columns). Prove nothing imports
 * it, and that if it is ever wired in it still cannot mint a reserved `mob-` row.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '__tests__']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('legacy enhanced_weather_rewards.ts (#1310 P3-b)', () => {
  const self = path.join(ROOT, 'server', 'enhanced_weather_rewards.ts');

  it('is not imported or required by any source file', () => {
    const importers = sourceFiles(ROOT).filter(
      (f) => f !== self && /enhanced_weather_rewards/.test(fs.readFileSync(f, 'utf8'))
    );
    expect(importers.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("rejects a reserved 'mob-' station id before its legacy insert can run", () => {
    const src = fs.readFileSync(self, 'utf8');
    const guard = src.indexOf('isReservedMobileStationId(weatherData.stationId)');
    const insert = src.indexOf('INSERT INTO weather_stations');
    expect(guard).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(insert);
  });
});
