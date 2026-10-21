/**
 * infra#1113 (data cap, owner ruling 2026-09-27): on linux/x64,
 * onnxruntime-node's postinstall downloads the ~238 MB NuGet package
 * Microsoft.ML.OnnxRuntime.Gpu.Linux on every `npm ci`, unless its install
 * flag says `skip`. The repo-root .npmrc sets `onnxruntime-node-install=skip`.
 *
 * This suite checks every link of that chain, so it fails if any one breaks:
 *   1. the .npmrc line exists;
 *   2. npm exports it to scripts run in this repo as
 *      npm_config_onnxruntime_node_install. npm 11 already warns "Unknown
 *      project config ... will stop working in the next major version", so
 *      this is the link most likely to break;
 *   3. the installed onnxruntime-node treats that value as "skip". Its
 *      install.js then exits before it resolves or downloads anything.
 * On a GitHub Actions linux/x64 runner it also checks the outcome: after
 * `npm ci`, the CUDA provider library that the NuGet package would supply
 * is absent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const ORT = path.join(ROOT, 'node_modules', 'onnxruntime-node');
const FLAG_ENV = [
  'ONNXRUNTIME_NODE_INSTALL',
  'ONNXRUNTIME_NODE_INSTALL_CUDA',
  'npm_config_onnxruntime_node_install',
  'npm_config_onnxruntime_node_install_cuda',
];

function envWithoutFlags(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of FLAG_ENV) delete env[key];
  return env;
}

describe('onnxruntime-node GPU download is skipped (infra#1113)', () => {
  it('.npmrc declares onnxruntime-node-install=skip', () => {
    const npmrc = readFileSync(path.join(ROOT, '.npmrc'), 'utf8');
    expect(npmrc).toMatch(/^onnxruntime-node-install=skip$/m);
  });

  it('npm exports the key to scripts run in this repo', () => {
    const out = execFileSync(
      'npm',
      ['exec', '--offline', '-c', 'node -p process.env.npm_config_onnxruntime_node_install'],
      { cwd: ROOT, env: envWithoutFlags(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    expect(out.trim().split('\n').pop()).toBe('skip');
  });

  it("onnxruntime-node's installer reads that value as skip", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parseInstallFlag } = require(path.join(ORT, 'script', 'install-utils.js'));
    const saved = { ...process.env };
    try {
      for (const key of FLAG_ENV) delete process.env[key];
      process.env.npm_config_onnxruntime_node_install = 'skip';
      expect(parseInstallFlag()).toBe(false);
      // Control: with no flag at all, linux/x64 would install cuda12.
      delete process.env.npm_config_onnxruntime_node_install;
      expect(parseInstallFlag()).not.toBe(false);
    } finally {
      process.env = saved;
    }
  });

  if (process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux' && process.arch === 'x64') {
    it('npm ci on this runner did not fetch the CUDA providers', () => {
      const cuda = path.join(ORT, 'bin', 'napi-v6', 'linux', 'x64', 'libonnxruntime_providers_cuda.so');
      expect(existsSync(cuda)).toBe(false);
    });
  }
});
