#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SCAN_PATHS = [
  'server/middleware',
  'server/routes',
  'server/config',
  'src',
];
const TEXT_EXTENSIONS = new Set(['.ts', '.js', '.json', '.mjs', '.cjs']);
const BLOCKED_LITERALS = [
  'openforis-demo-key-free-12345',
  'openforis-demo-key-premium-67890',
  'openforis-demo-key-enterprise-abcdef',
  'openforis-demo-key-admin-xyz789',
  'openforis-demo-jwt-token-12345',
  'openforis-demo-secret-key',
];

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  'test-results',
  '__tests__',
  'docs',
]);

const filesToScan = [];

const collectFiles = dirPath => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath);
      continue;
    }

    if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      filesToScan.push(fullPath);
    }
  }
};

for (const relativeScanPath of SCAN_PATHS) {
  const absoluteScanPath = path.join(BACKEND_ROOT, relativeScanPath);
  if (fs.existsSync(absoluteScanPath)) {
    collectFiles(absoluteScanPath);
  }
}

const findings = [];

for (const absolutePath of filesToScan) {
  const content = fs.readFileSync(absolutePath, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, lineIndex) => {
    BLOCKED_LITERALS.forEach(literal => {
      if (line.includes(literal)) {
        findings.push({
          file: path.relative(BACKEND_ROOT, absolutePath),
          line: lineIndex + 1,
          literal,
        });
      }
    });
  });
}

if (findings.length > 0) {
  console.error('Found blocked OpenForis demo credentials in runtime paths:');
  findings.forEach(finding => {
    console.error(
      `  - ${finding.file}:${finding.line} contains "${finding.literal}"`
    );
  });
  process.exit(1);
}

console.log(
  `No blocked OpenForis demo credentials found in runtime paths (${SCAN_PATHS.join(', ')}).`
);
