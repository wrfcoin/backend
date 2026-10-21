import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const vectors = JSON.parse(readFileSync(new URL('vectors.json', import.meta.url), 'utf8'));
const inputs = vectors.flatMap(v => [v.raw, v.quantized]);
const run = spawnSync('cargo', ['run', '--offline', '--locked', '--quiet', '--manifest-path', `${directory}Cargo.toml`], {
  cwd: directory,
  env: { ...process.env, CARGO_BUILD_JOBS: '3', CARGO_TARGET_DIR: `${directory}target` },
  input: `${inputs.join('\n')}\n`,
  encoding: 'utf8',
});
if (run.error || run.status !== 0) {
  process.stderr.write(run.error?.message ?? run.stderr);
  process.exit(1);
}
const output = run.stdout.trimEnd().split('\n');
if (output.length !== inputs.length) throw new Error(`generator emitted ${output.length} lines for ${inputs.length} inputs`);
let differences = 0;
vectors.forEach((v, index) => {
  for (const [column, offset] of [['rawRust', 0], ['quantizedRust', 1]]) {
    if (output[index * 2 + offset] !== v[column]) {
      console.error(`vector ${index} ${column}: stored ${v[column]}, generator ${output[index * 2 + offset]}`);
      differences++;
    }
  }
});
console.log(`${output.length - differences}/${output.length} fixture strings match serde_json =1.0.149`);
process.exitCode = differences ? 1 : 0;
