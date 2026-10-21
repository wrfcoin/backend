import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const guidePath = path.join(repoRoot, 'server', 'SERVICE_REGISTRY.md');
const serverDir = path.join(repoRoot, 'server');

const guide = readFileSync(guidePath, 'utf8');
const registryMatch = guide.match(/## Service Registry\n([\s\S]*?)\n---/);

if (!registryMatch) {
  console.error('Unable to find the server service registry in server/SERVICE_REGISTRY.md.');
  process.exit(1);
}

const registry = registryMatch[1];
const documentedFiles = Array.from(
  registry.matchAll(/`([^`]+\.(?:js|ts))`/g),
  match => match[1]
);

const missingFiles = documentedFiles.filter(file => !existsSync(path.join(serverDir, file)));

if (missingFiles.length > 0) {
  console.error('server/SERVICE_REGISTRY.md documents service files that do not exist:');
  for (const file of missingFiles) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

console.log(
  `server/SERVICE_REGISTRY.md service registry matches ${documentedFiles.length} files in server/.`
);
