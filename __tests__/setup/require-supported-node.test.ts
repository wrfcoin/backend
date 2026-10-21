import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('./require-supported-node.cjs');

describe('require-supported-node (jest globalSetup guard)', () => {
  it('reads the required major from package.json engines, not a constant', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    expect(guard.requiredMajor(pkg.engines.node)).toBe(24);
    expect(guard.requiredMajor('^22.1.0')).toBe(22);
    expect(guard.requiredMajor(undefined)).toBeNull();
  });

  it('refuses an older major with the one clear message', () => {
    expect(guard.checkNodeVersion('v20.20.2', '^24.15.0')).toBe(
      'backend tests require Node >=24 (engines: ^24.15.0); running v20.20.2',
    );
    expect(guard.checkNodeVersion('v22.23.2', '^24.15.0')).toContain('running v22.23.2');
  });

  it('allows the required major and newer', () => {
    for (const v of ['v24.15.0', 'v24.0.0', 'v25.1.0', '24.15.0']) {
      expect(guard.checkNodeVersion(v, '^24.15.0')).toBeNull();
    }
  });

  it('does not block when it cannot decide (no engines field, unparseable version)', () => {
    expect(guard.checkNodeVersion('v20.0.0', undefined)).toBeNull();
    expect(guard.checkNodeVersion('weird', '^24.15.0')).toBeNull();
  });

  it('the running Node satisfies the guard (this suite only runs when the globalSetup passed)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    expect(guard.checkNodeVersion(process.version, pkg.engines.node)).toBeNull();
  });

  it('jest.standalone.cjs wires the guard as globalSetup', () => {
    const cfg = require('../jest.standalone.cjs');
    expect(cfg.globalSetup).toBe('<rootDir>/__tests__/setup/require-supported-node.cjs');
  });
});
