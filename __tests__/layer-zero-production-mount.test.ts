import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const entrypoint = fs.readFileSync(
  path.join(repoRoot, 'server/enhanced_unified_api_optimized.ts'),
  'utf8',
);
const routerSource = fs.readFileSync(
  path.join(repoRoot, 'server/routes/layer-zero-routes.ts'),
  'utf8',
);

describe('backend#1027 LayerZero production mount', () => {
  it('mounts the router through required safeMount before the catch-all', () => {
    const mount = /safeMount\(\s*'\/api\/layer-zero'\s*,\s*'\.\/routes\/layer-zero-routes'\s*\);/;
    const mountIndex = entrypoint.search(mount);
    const catchAllIndex = entrypoint.indexOf(
      'Catch-all: forward unmatched requests to the existing inline handleRequest',
    );

    expect(mountIndex).toBeGreaterThan(-1);
    expect(catchAllIndex).toBeGreaterThan(mountIndex);
  });

  it('keeps authentication ahead of every mounted LayerZero handler', () => {
    const authIndex = routerSource.indexOf('router.use(authenticateJWT);');
    const firstHandlerIndex = routerSource.indexOf("router.get('/chains'");

    expect(authIndex).toBeGreaterThan(-1);
    expect(firstHandlerIndex).toBeGreaterThan(authIndex);
  });
});
