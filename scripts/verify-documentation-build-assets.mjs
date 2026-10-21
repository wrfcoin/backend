import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const sourceIndexPath = 'server/data/documentation-index.json';
const distIndexPath = path.join('dist', sourceIndexPath);
const sourceIndexText = await readFile(sourceIndexPath, 'utf8');
const distIndexText = await readFile(distIndexPath, 'utf8');
assert.equal(distIndexText, sourceIndexText, 'built documentation index drifted');

const index = JSON.parse(sourceIndexText);
assert.ok(index.length > 0, 'documentation index must not be empty');
for (const entry of index) {
  assert.equal(typeof entry.path, 'string');
  const source = await readFile(entry.path, 'utf8');
  const built = await readFile(path.join('dist', entry.path), 'utf8');
  assert.equal(built, source, `built documentation asset drifted: ${entry.path}`);
}

console.log(`verify-documentation-build-assets: OK — ${index.length} indexed documents shipped`);
