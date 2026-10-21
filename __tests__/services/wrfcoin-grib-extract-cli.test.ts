import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

describe('wrfcoin-grib-extract CLI', () => {
  it('extracts requested variable from fixture input', async () => {
    const root = path.resolve(__dirname, '../..');
    const cliPath = path.join(root, 'scripts', 'wrfcoin-grib-extract.mjs');
    const fixturePath = path.join(
      root,
      '__tests__',
      'fixtures',
      'forecast',
      'sample_gfs.json'
    );

    const { stdout } = await execFileAsync('npx', [
      'tsx',
      cliPath,
      fixturePath,
      'temperature',
      '--format',
      'grib2',
    ]);

    const parsed = JSON.parse(stdout);
    expect(parsed.variable).toBe('temperature');
    expect(parsed.sourceFormat).toBe('grib2');
  });

  it('fails fast on unsupported variable', async () => {
    const root = path.resolve(__dirname, '../..');
    const cliPath = path.join(root, 'scripts', 'wrfcoin-grib-extract.mjs');
    const fixturePath = path.join(
      root,
      '__tests__',
      'fixtures',
      'forecast',
      'sample_gfs.json'
    );

    await expect(
      execFileAsync('npx', ['tsx', cliPath, fixturePath, 'bad_variable'])
    ).rejects.toThrow('Invalid variable');
  });
});
