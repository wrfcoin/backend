#!/usr/bin/env node
'use strict';

/**
 * Hygiene check: detect untracked TypeScript/JavaScript files under tracked
 * source directories. Exits non-zero if any are found so it can run in CI or
 * as a pre-push gate.
 *
 * Background: backend#716 — sprint agents occasionally write files into the
 * shared main checkout instead of their assigned worktree, producing orphans
 * that are invisible to CI and code review until deliberately committed.
 *
 * Run: node scripts/check-untracked-sources.cjs
 *      npm run hygiene:check-untracked
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

const SOURCE_DIRS = [
  'services',
  'server',
  'shared',
  'api',
  'middleware',
  'routes',
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs']);

function getUntrackedFiles(cwd, opts = {}) {
  const { strict = true } = opts;
  try {
    const out = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd,
      encoding: 'utf8',
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    if (!strict) {
      return null;
    }
    console.error(`ERROR: git ls-files failed in ${cwd} — is this a git repository?`);
    process.exit(2);
  }
}

function getWorktreePaths() {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    const paths = out
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).trim())
      .filter(Boolean);

    return paths.length > 0 ? paths : [REPO_ROOT];
  } catch {
    // Fallback for older git or non-worktree environments.
    return [REPO_ROOT];
  }
}

function findOrphanedSources(untrackedFiles) {
  return untrackedFiles.filter(f => {
    if (!SOURCE_EXTENSIONS.has(path.extname(f))) return false;
    return SOURCE_DIRS.some(dir => f === dir || f.startsWith(dir + '/'));
  });
}

function collectOrphanReports(worktreePaths = getWorktreePaths()) {
  const orphanReports = [];
  const skippedWorktrees = [];

  for (const worktreePath of worktreePaths) {
    if (!fs.existsSync(worktreePath)) {
      skippedWorktrees.push(worktreePath);
      continue;
    }

    const untracked = getUntrackedFiles(worktreePath, { strict: false });
    if (untracked === null) {
      skippedWorktrees.push(worktreePath);
      continue;
    }

    const orphans = findOrphanedSources(untracked);
    if (orphans.length > 0) {
      orphanReports.push({ worktreePath, orphans });
    }
  }

  return { orphanReports, skippedWorktrees };
}

function run() {
  const { orphanReports, skippedWorktrees } = collectOrphanReports();

  if (orphanReports.length === 0) {
    console.log('OK: no untracked source files under tracked source directories in any linked worktree.');
    process.exit(0);
  }

  process.stderr.write(
    '\nERROR: untracked source files found in tracked directories:\n'
  );

  for (const report of orphanReports) {
    process.stderr.write(`\nworktree: ${report.worktreePath}\n`);
    for (const filePath of report.orphans) {
      process.stderr.write(`  ??  ${filePath}\n`);
    }
  }

  if (skippedWorktrees.length > 0) {
    process.stderr.write('\nSkipped invalid worktree entries:\n');
    for (const worktreePath of skippedWorktrees) {
      process.stderr.write(`  - ${worktreePath}\n`);
    }
  }

  process.stderr.write(`
These files exist in a linked worktree but have no git history.
They are invisible to CI and code review until deliberately committed.

This check scans all linked worktrees to catch cross-worktree orphans
(for example backend#715 where services/slack-bridge.ts existed only in
the shared checkout while feature work proceeded in another worktree).

For each file, choose one action:

  1. Commit to its owning feature branch (never commit from a shared checkout):
       cp <repo-root>/<file> <worktree>/<file>
       git -C <worktree> add <file>
       git -C <worktree> commit -m "..."

  2. Delete the orphan:
       rm <repo-root>/<file>

  3. Mark intentionally untracked (only if it genuinely should not be versioned):
       echo "<file>" >> .gitignore

See server/SERVICE_REGISTRY.md for the full decision runbook.
`);
  process.exit(1);
}

if (require.main === module) {
  run();
}

module.exports = {
  collectOrphanReports,
  findOrphanedSources,
  getUntrackedFiles,
  getWorktreePaths,
  run,
};
