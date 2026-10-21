import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const enhancedApiPath = path.join(repoRoot, 'server/enhanced_unified_api_optimized.ts');

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('production route build regression guard (#791)', () => {
  it('keeps prod on the unbundled tsc output instead of dist/server.cjs', () => {
    const packageJson = JSON.parse(readRepoFile('package.json'));
    const dockerfile = readRepoFile('Dockerfile');

    expect(packageJson.scripts.build).toContain('tsc');
    expect(packageJson.scripts.start).toBe('node dist/server/enhanced_unified_api_optimized.js');
    expect(packageJson.scripts['start:main-api']).toBe(
      'node dist/server/enhanced_unified_api_optimized.js'
    );

    expect(dockerfile).toContain('RUN npm run build');
    expect(dockerfile).toContain('CMD ["node", "dist/server/enhanced_unified_api_optimized.js"]');
    expect(dockerfile).not.toContain('dist/server.cjs');
  });

  it('emits every safe-mounted modular route under dist/server/routes', () => {
    const tsconfigBase = JSON.parse(readRepoFile('tsconfig.base.json'));
    const tsconfig = JSON.parse(readRepoFile('tsconfig.json'));
    const source = readRepoFile('server/enhanced_unified_api_optimized.ts');
    const copyBuildAssets = readRepoFile('scripts/copy-build-assets.mjs');
    const routeMounts = Array.from(
      source.matchAll(/safeMount\(\s*['"]([^'"]+)['"]\s*,\s*['"]\.\/routes\/([^'"]+)['"]\s*\)/g)
    ).map((match) => ({ mountPath: match[1], moduleName: match[2] }));

    expect(routeMounts.length).toBeGreaterThanOrEqual(40);
    expect(routeMounts).toContainEqual({
      mountPath: '/api/weather',
      moduleName: 'weather-routes',
    });

    expect(tsconfig.compilerOptions.outDir).toBe('./dist');
    expect(tsconfig.compilerOptions.rootDir).toBe('.');
    expect(tsconfigBase.compilerOptions.allowJs).toBe(true);
    expect(tsconfig.include).toContain('server/**/*.ts');
    expect(copyBuildAssets).toContain("'server'");
    expect(copyBuildAssets).toContain('copyJsOnlyRuntimeSources');
    expect(copyBuildAssets).toContain("'.cjs'");
    expect(source).toContain('const cjsModulePath = `${modulePath}.cjs`;');

    const missingSources = routeMounts.filter(({ moduleName }) => {
      const routeBase = path.join(repoRoot, 'server/routes', moduleName);
      return !existsSync(`${routeBase}.ts`) && !existsSync(`${routeBase}.js`);
    });

    expect(missingSources).toEqual([]);
  });

  it('rewrites directory-style requires to the emitted index.cjs shim', () => {
    // A `require('../../config')` resolving to a directory would otherwise pick
    // the ESM-classified `index.js` (because of `"type": "module"`) and break
    // at runtime. The build must re-point such requires at `index.cjs`.
    const copyBuildAssets = readRepoFile('scripts/copy-build-assets.mjs');
    expect(copyBuildAssets).toContain('index.cjs');
    expect(copyBuildAssets).toMatch(/index\.js/);
  });

  it('keeps climate-oracle-network on an ESM export so require(esm) sees the class', () => {
    // The module uses ESM `import` syntax, so a CommonJS `module.exports =` is a
    // no-op and left the named export empty (new ClimateOracleNetwork() threw
    // "not a constructor") on the compiled prod build. Guard the ESM export.
    const oracleSource = readRepoFile('server/oracle/climate-oracle-network.ts');
    expect(oracleSource).toMatch(/export\s*\{\s*ClimateOracleNetwork\s*\}/);
    expect(oracleSource).not.toContain('module.exports = { ClimateOracleNetwork }');
  });
});
