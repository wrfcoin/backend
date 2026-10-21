/**
 * #1277 review P2: the core4-http-contract job keeps a persistent per-runner
 * core4 clone (infra#1113 data cap). A job killed mid-fetch or mid-checkout
 * can leave .git/shallow.lock or .git/index.lock behind. Plain git then fails
 * every later run (exit 128) until someone cleans the runner by hand.
 * scripts/ci-sync-core4-contract.sh must heal that itself: delete the clone
 * and re-sync once.
 *
 * Fixture: a local bare repo reached via file://, so depth=1 is honoured and
 * the test needs no network.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ci-sync-core4-contract.sh');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ci-test',
  GIT_AUTHOR_EMAIL: 'ci-test@example.invalid',
  GIT_COMMITTER_NAME: 'ci-test',
  GIT_COMMITTER_EMAIL: 'ci-test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

describe('ci-sync-core4-contract.sh (persistent clone self-heal)', () => {
  let root: string;
  let work: string;
  let remoteUrl: string;
  let clone: string;

  function commit(msg: string): string {
    writeFileSync(path.join(work, 'file.txt'), `${msg}\n`);
    git(['add', 'file.txt'], work);
    git(['commit', '-q', '-m', msg], work);
    git(['push', '-q', 'origin', 'HEAD:main'], work);
    return git(['rev-parse', 'HEAD'], work);
  }

  function sync() {
    return spawnSync('bash', [SCRIPT, clone, remoteUrl], { env: GIT_ENV, encoding: 'utf8' });
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'core4-contract-'));
    const bare = path.join(root, 'core4.git');
    work = path.join(root, 'work');
    clone = path.join(root, 'core4-contract');
    git(['init', '-q', '--bare', bare]);
    git(['init', '-q', work]);
    git(['remote', 'add', 'origin', bare], work);
    remoteUrl = `file://${bare}`;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('first run clones main; a later run fetches the new tip and cleans untracked files', () => {
    const first = commit('one');
    let r = sync();
    expect(r.status).toBe(0);
    expect(git(['rev-parse', 'HEAD'], clone)).toBe(first);

    writeFileSync(path.join(clone, 'stale-build-output'), 'x');
    const second = commit('two');
    r = sync();
    expect(r.status).toBe(0);
    expect(git(['rev-parse', 'HEAD'], clone)).toBe(second);
    expect(existsSync(path.join(clone, 'stale-build-output'))).toBe(false);
  });

  it.each(['shallow.lock', 'index.lock'])(
    'recovers from a leftover .git/%s (killed mid-fetch/checkout)',
    (lock) => {
      commit('one');
      expect(sync().status).toBe(0);
      const tip = commit('two');
      writeFileSync(path.join(clone, '.git', lock), '');

      // Control: the fixture really reproduces the outage. Plain git fails.
      const plain = spawnSync(
        'bash',
        ['-c', 'git fetch -q --depth=1 origin +refs/heads/main:refs/remotes/origin/main && git checkout -q --force --detach refs/remotes/origin/main'],
        { cwd: clone, env: GIT_ENV, encoding: 'utf8' },
      );
      expect(plain.status).not.toBe(0);

      const r = sync();
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/re-cloning once/);
      expect(git(['rev-parse', 'HEAD'], clone)).toBe(tip);
      expect(existsSync(path.join(clone, '.git', lock))).toBe(false);
    },
  );

  it('fails the step when the retry also fails (real outage, not a lock)', () => {
    commit('one');
    const r = spawnSync('bash', [SCRIPT, clone, `file://${path.join(root, 'missing.git')}`], {
      env: GIT_ENV,
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/re-cloning once/);
  });
});
